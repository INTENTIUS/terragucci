"""terragucci-decide: Laya behind the Jev request and response shape, as one pinned model.

Laya's own `laya-serve` (laya[serve]) already answers `POST /v1/systemone` in
the Jev shape: a `state`, named questions of type noul, choice or score, and
typed answers with probabilities. This wrapper adds the one thing a recorded
decision needs from it, a model id that names what answered:

  * The service answers as DECIDE_MODEL (package, checkpoint and Hub commit,
    such as laya-0.3.28-english@55cf4c4ebb4e). A request may name that id or
    no model; any other model is refused with a 422 rather than answered by
    whatever is loaded, so a client pinned to another version finds out.
  * Every decision runs on DECIDE_CHECKPOINT, never on a checkpoint Laya's
    router would pick from the text, so one id always means one set of weights.
  * The response's `model` field is DECIDE_MODEL, where laya-serve reports the
    constant name of its decision head.
  * `GET /v1/models` lists the one id, as other Jev-compatible servers do.

Everything else (limits, errors, `/health`, the batch route) is laya-serve's,
configured by its LAYA_* environment variables. The image sets them: CPU,
one preloaded checkpoint, the pinned revision, its weights' SHA-256 and no Hub
access at run time.
"""
import json
import os

import uvicorn
from laya.serve import create_app

MODEL_ID = os.environ["DECIDE_MODEL"]
CHECKPOINT = os.environ.get("DECIDE_CHECKPOINT", "english")
PORT = int(os.environ.get("DECIDE_PORT", "8790"))
DECISION_PATHS = ("/v1/systemone", "/v1/systemone/batch")
# laya-serve refuses a body over 2 MiB itself; this bound only stops the wrapper
# from buffering more than that before handing it on.
MAX_BODY = 2 * 1024 * 1024

inner = create_app()


async def _send_json(send, status, payload):
    body = json.dumps(payload).encode("utf-8")
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
    })
    await send({"type": "http.response.body", "body": body})


def _with_length(headers, length):
    kept = [(k, v) for k, v in headers if k.lower() not in (b"content-length", b"transfer-encoding")]
    return kept + [(b"content-length", str(length).encode())]


def _stamp(result):
    """Name the pinned model in a decision response (single or batch)."""
    if isinstance(result, dict):
        if "model" in result:
            result["model"] = MODEL_ID
        for value in result.values():
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict) and "model" in item:
                        item["model"] = MODEL_ID
    return result


async def app(scope, receive, send):
    if scope["type"] != "http":
        await inner(scope, receive, send)
        return
    method, path = scope["method"], scope["path"]
    if method == "GET" and path == "/v1/models":
        await _send_json(send, 200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "terragucci-decide"}]})
        return
    if method != "POST" or path not in DECISION_PATHS:
        await inner(scope, receive, send)
        return

    chunks, size = [], 0
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return
        chunk = message.get("body", b"")
        size += len(chunk)
        if size > MAX_BODY:
            await _send_json(send, 413, {"detail": "request body is over 2 MiB"})
            return
        chunks.append(chunk)
        if not message.get("more_body", False):
            break
    raw = b"".join(chunks)

    try:
        body = json.loads(raw)
    except ValueError:
        body = None  # laya-serve answers a malformed body with its own 400
    if isinstance(body, dict):
        asked = body.get("model")
        if asked is not None and asked != MODEL_ID:
            await _send_json(send, 422, {
                "detail": f"this service answers as {MODEL_ID}, and the request names {asked!r}; "
                          f"set decide.model to {MODEL_ID}, or point decide.url at a service that serves {asked!r}",
            })
            return
        body["model"] = CHECKPOINT
        raw = json.dumps(body).encode("utf-8")

    replayed = False

    async def replay():
        nonlocal replayed
        if replayed:
            return await receive()
        replayed = True
        return {"type": "http.request", "body": raw, "more_body": False}

    inner_scope = dict(scope, headers=_with_length(scope["headers"], len(raw)))
    start = None
    out = []

    async def capture(message):
        nonlocal start
        if message["type"] == "http.response.start":
            start = message
            return
        if message["type"] != "http.response.body":
            await send(message)
            return
        out.append(message.get("body", b""))
        if message.get("more_body", False):
            return
        payload = b"".join(out)
        if start["status"] == 200:
            try:
                payload = json.dumps(_stamp(json.loads(payload))).encode("utf-8")
            except ValueError:
                pass
        await send(dict(start, headers=_with_length(start.get("headers", []), len(payload))))
        await send({"type": "http.response.body", "body": payload})

    await inner(inner_scope, replay, capture)


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("DECIDE_HOST", "0.0.0.0"), port=PORT, log_level=os.environ.get("LAYA_LOG_LEVEL", "info"))
