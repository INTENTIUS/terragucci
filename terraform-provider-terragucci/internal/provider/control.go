package provider

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"

	"gopkg.in/yaml.v3"
)

// control is the control repo's terragucci.yml on one branch. Every resource
// edits its own key of the one file, so writes go through a lock per file and
// re-read the file when the forge says it moved.
type control struct {
	forge  *forge
	branch string
	path   string

	branchOnce sync.Once
	branchErr  error
}

// resolve fills branch with the repository's default branch when the provider block names none.
func (c *control) resolve(ctx context.Context) error {
	c.branchOnce.Do(func() {
		if c.branch == "" {
			c.branch, c.branchErr = c.forge.defaultBranch(ctx)
		}
	})
	return c.branchErr
}

var (
	locksMu sync.Mutex
	locks   = map[string]*sync.Mutex{}
)

func (c *control) lock() func() {
	id := c.forge.api + "|" + c.forge.repo + "|" + c.branch + "|" + c.path
	locksMu.Lock()
	m, ok := locks[id]
	if !ok {
		m = &sync.Mutex{}
		locks[id] = m
	}
	locksMu.Unlock()
	m.Lock()
	return m.Unlock
}

// load reads and parses the file. A missing or empty file is an empty mapping.
func (c *control) load(ctx context.Context) (*yaml.Node, file, error) {
	if err := c.resolve(ctx); err != nil {
		return nil, file{}, err
	}
	f, err := c.forge.read(ctx, c.path, c.branch)
	if err != nil {
		return nil, f, err
	}
	root, err := parseDoc(f.content)
	if err != nil {
		return nil, f, fmt.Errorf("%s on %s: %w", c.path, c.branch, err)
	}
	return root, f, nil
}

// edit applies fn to the file's top-level mapping and commits the result when
// fn reports a change. A file left with no keys is deleted.
func (c *control) edit(ctx context.Context, message string, fn func(root *yaml.Node) (bool, error)) error {
	if err := c.resolve(ctx); err != nil {
		return err
	}
	unlock := c.lock()
	defer unlock()
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		var root *yaml.Node
		var f file
		root, f, err = c.load(ctx)
		if err != nil {
			return err
		}
		changed, ferr := fn(root)
		if ferr != nil {
			return ferr
		}
		if !changed {
			return nil
		}
		if len(root.Content) == 0 {
			if !f.exists {
				return nil
			}
			err = c.forge.remove(ctx, c.path, c.branch, f, message)
		} else {
			var out []byte
			out, err = renderDoc(root)
			if err != nil {
				return err
			}
			err = c.forge.write(ctx, c.path, c.branch, out, f, message)
		}
		if err == nil || !errors.Is(err, errConflict) {
			return err
		}
	}
	return err
}

// parseDoc parses YAML into its top-level mapping node.
func parseDoc(content []byte) (*yaml.Node, error) {
	if len(bytes.TrimSpace(content)) == 0 {
		return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}, nil
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(content, &doc); err != nil {
		return nil, fmt.Errorf("not valid YAML: %w", err)
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 {
		return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}, nil
	}
	root := doc.Content[0]
	if root.Kind == yaml.ScalarNode && root.Tag == "!!null" {
		return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", HeadComment: root.HeadComment}, nil
	}
	if root.Kind != yaml.MappingNode {
		return nil, errors.New("the top level is not a mapping")
	}
	return root, nil
}

// renderDoc writes a mapping back as YAML, indented by two.
func renderDoc(root *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{root}}); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// lookup returns the value of key in a mapping node, or nil.
func lookup(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// put sets key in a mapping node, in place when it is there, else at the end.
func put(m *yaml.Node, key string, v *yaml.Node) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			v.HeadComment, v.LineComment, v.FootComment = m.Content[i+1].HeadComment, m.Content[i+1].LineComment, m.Content[i+1].FootComment
			m.Content[i+1] = v
			return
		}
	}
	m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, v)
}

// drop removes key from a mapping node and says whether it was there.
func drop(m *yaml.Node, key string) bool {
	if m == nil || m.Kind != yaml.MappingNode {
		return false
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
			return true
		}
	}
	return false
}

// encodeValue is a Go value as a YAML node, maps with their keys sorted.
func encodeValue(v any) (*yaml.Node, error) {
	var n yaml.Node
	if err := n.Encode(v); err != nil {
		return nil, err
	}
	return &n, nil
}

// decodeValue is a YAML node as plain Go values.
func decodeValue(n *yaml.Node) (any, error) {
	var v any
	if err := n.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// setDefaults writes defaults, first in the file when it is new there.
func setDefaults(root *yaml.Node, v *yaml.Node) {
	if lookup(root, "defaults") != nil {
		put(root, "defaults", v)
		return
	}
	key := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "defaults"}
	root.Content = append([]*yaml.Node{key, v}, root.Content...)
}

// projectSettings is projects[key] of the file, or nil when it is absent.
func projectSettings(root *yaml.Node, key string) *yaml.Node {
	return lookup(lookup(root, "projects"), key)
}

// setProject writes projects[key], making projects when there is none.
func setProject(root *yaml.Node, key string, v *yaml.Node) error {
	projects := lookup(root, "projects")
	if projects == nil || (projects.Kind == yaml.ScalarNode && projects.Tag == "!!null") {
		projects = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		put(root, "projects", projects)
	}
	if projects.Kind != yaml.MappingNode {
		return errors.New("projects in the file is not a mapping")
	}
	put(projects, key, v)
	return nil
}

// dropProject removes projects[key], and projects with it when it is left empty.
func dropProject(root *yaml.Node, key string) bool {
	projects := lookup(root, "projects")
	if !drop(projects, key) {
		return false
	}
	if len(projects.Content) == 0 {
		drop(root, "projects")
	}
	return true
}
