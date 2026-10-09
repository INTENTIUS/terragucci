package provider

import (
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"time"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"
)

// toGo turns a configured value into plain Go values: objects and maps become
// map[string]any, lists, sets and tuples []any. A null attribute is left out,
// so `x = null` leaves the key unset.
func toGo(v attr.Value) (any, error) {
	if v == nil || v.IsNull() {
		return nil, nil
	}
	if v.IsUnknown() {
		return nil, fmt.Errorf("a value is not known yet")
	}
	switch t := v.(type) {
	case basetypes.DynamicValue:
		return toGo(t.UnderlyingValue())
	case basetypes.StringValue:
		return t.ValueString(), nil
	case basetypes.BoolValue:
		return t.ValueBool(), nil
	case basetypes.NumberValue:
		return numberToGo(t.ValueBigFloat()), nil
	case basetypes.Int64Value:
		return t.ValueInt64(), nil
	case basetypes.Float64Value:
		return t.ValueFloat64(), nil
	case basetypes.ObjectValue:
		return mapToGo(t.Attributes())
	case basetypes.MapValue:
		return mapToGo(t.Elements())
	case basetypes.ListValue:
		return listToGo(t.Elements())
	case basetypes.SetValue:
		return listToGo(t.Elements())
	case basetypes.TupleValue:
		return listToGo(t.Elements())
	}
	return nil, fmt.Errorf("a %s cannot go in terragucci.yml", v.Type(nil))
}

func numberToGo(f *big.Float) any {
	if f == nil {
		return nil
	}
	if f.IsInt() {
		if i, acc := f.Int64(); acc == big.Exact {
			return int(i)
		}
	}
	x, _ := f.Float64()
	return x
}

func mapToGo(m map[string]attr.Value) (map[string]any, error) {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if v == nil || v.IsNull() {
			continue
		}
		g, err := toGo(v)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", k, err)
		}
		out[k] = g
	}
	return out, nil
}

func listToGo(l []attr.Value) ([]any, error) {
	out := make([]any, 0, len(l))
	for i, v := range l {
		g, err := toGo(v)
		if err != nil {
			return nil, fmt.Errorf("[%d]: %w", i, err)
		}
		out = append(out, g)
	}
	return out, nil
}

// fromGo turns values decoded from YAML into a Terraform value: a mapping is
// an object and a sequence a tuple, the types an HCL literal has.
func fromGo(v any) (attr.Value, error) {
	switch t := v.(type) {
	case nil:
		return types.DynamicNull(), nil
	case string:
		return types.StringValue(t), nil
	case bool:
		return types.BoolValue(t), nil
	case int:
		return types.NumberValue(new(big.Float).SetInt64(int64(t))), nil
	case int64:
		return types.NumberValue(new(big.Float).SetInt64(t)), nil
	case uint64:
		return types.NumberValue(new(big.Float).SetUint64(t)), nil
	case float64:
		return types.NumberValue(big.NewFloat(t)), nil
	case time.Time:
		return types.StringValue(t.Format(time.RFC3339)), nil
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		attrTypes := map[string]attr.Type{}
		attrs := map[string]attr.Value{}
		for _, k := range keys {
			e, err := fromGo(t[k])
			if err != nil {
				return nil, fmt.Errorf("%s: %w", k, err)
			}
			attrTypes[k] = e.Type(nil)
			attrs[k] = e
		}
		o, diags := types.ObjectValue(attrTypes, attrs)
		if diags.HasError() {
			return nil, fmt.Errorf("%v", diags)
		}
		return o, nil
	case map[any]any:
		m := make(map[string]any, len(t))
		for k, e := range t {
			m[fmt.Sprint(k)] = e
		}
		return fromGo(m)
	case []any:
		elemTypes := make([]attr.Type, 0, len(t))
		elems := make([]attr.Value, 0, len(t))
		for i, e := range t {
			ev, err := fromGo(e)
			if err != nil {
				return nil, fmt.Errorf("[%d]: %w", i, err)
			}
			elemTypes = append(elemTypes, ev.Type(nil))
			elems = append(elems, ev)
		}
		tv, diags := types.TupleValue(elemTypes, elems)
		if diags.HasError() {
			return nil, fmt.Errorf("%v", diags)
		}
		return tv, nil
	}
	return nil, fmt.Errorf("a %T cannot be read back from terragucci.yml", v)
}

// sameSettings says whether two plain values write the same YAML: numbers
// compare by value, key order does not count, and nil equals an empty map.
func sameSettings(a, b any) bool {
	if isEmpty(a) && isEmpty(b) {
		return true
	}
	ja, errA := json.Marshal(a)
	jb, errB := json.Marshal(b)
	if errA != nil || errB != nil {
		return false
	}
	var na, nb any
	if json.Unmarshal(ja, &na) != nil || json.Unmarshal(jb, &nb) != nil {
		return false
	}
	ca, _ := json.Marshal(na)
	cb, _ := json.Marshal(nb)
	return string(ca) == string(cb)
}

func isEmpty(v any) bool {
	if v == nil {
		return true
	}
	m, ok := v.(map[string]any)
	return ok && len(m) == 0
}
