"""Session Scribe: record a D&D session, get great notes."""

import os
import time
import webbrowser

from flask import Flask, abort, jsonify, request, send_from_directory

import pipeline
import storage

ALLOWED_CHUNK_EXTS = {"webm", "ogg", "mp4", "m4a", "wav"}

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024**3  # uploaded recordings can be several hours long


def _session_or_404(session_id: str) -> dict:
    try:
        return storage.get_session(session_id)
    except KeyError:
        abort(404)


def _with_progress(session: dict) -> dict:
    sid = session["id"]
    return {
        **session,
        "chunks_received": len(storage.chunk_indexes(sid)),
        "chunks_transcribed": len(storage.transcribed_indexes(sid)),
    }


def _default_title() -> str:
    return "Session — " + time.strftime("%b %d, %Y")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/settings")
def get_settings():
    return jsonify(storage.get_settings())


@app.put("/api/settings")
def put_settings():
    body = request.get_json(force=True)
    return jsonify(storage.save_settings({"campaign_context": str(body.get("campaign_context", ""))}))


@app.get("/api/sessions")
def list_sessions():
    return jsonify([_with_progress(s) for s in storage.list_sessions()])


@app.post("/api/sessions")
def create_session():
    body = request.get_json(silent=True) or {}
    title = (body.get("title") or "").strip()
    session = storage.create_session(title or _default_title(), source="mic")
    if title:
        session = storage.update_session(session["id"], title_set_by_user=True)
    return jsonify(session), 201


@app.post("/api/sessions/upload")
def upload_recording():
    file = request.files.get("file")
    if not file or not file.filename:
        abort(400, "No file uploaded")
    title = (request.form.get("title") or "").strip()
    session = storage.create_session(title or _default_title(), source="upload")
    if title:
        storage.update_session(session["id"], title_set_by_user=True)
    ext = os.path.splitext(file.filename)[1].lower()[:10] or ".audio"
    dest = storage.session_dir(session["id"]) / f"original{ext}"
    file.save(dest)
    pipeline.process_upload(session["id"], dest)
    return jsonify(session), 201


@app.get("/api/sessions/<session_id>")
def get_session(session_id):
    return jsonify(_with_progress(_session_or_404(session_id)))


@app.patch("/api/sessions/<session_id>")
def rename_session(session_id):
    _session_or_404(session_id)
    title = (request.get_json(force=True).get("title") or "").strip()
    if not title:
        abort(400, "Title required")
    return jsonify(storage.update_session(session_id, title=title, title_set_by_user=True))


@app.delete("/api/sessions/<session_id>")
def delete_session(session_id):
    _session_or_404(session_id)
    storage.delete_session(session_id)
    return "", 204


@app.post("/api/sessions/<session_id>/chunks")
def upload_chunk(session_id):
    session = _session_or_404(session_id)
    if session["recording_finished"]:
        abort(409, "Recording already finished")
    index = request.args.get("index", type=int)
    ext = (request.args.get("ext") or "webm").lower()
    if index is None or index < 0 or ext not in ALLOWED_CHUNK_EXTS:
        abort(400, "Bad chunk")
    request.files["audio"].save(storage.chunks_dir(session_id) / f"{index:04d}.{ext}")
    storage.update_session(session_id, chunk_count=max(session["chunk_count"], index + 1))
    pipeline.enqueue_chunk(session_id, index)
    return jsonify({"ok": True})


@app.post("/api/sessions/<session_id>/finish")
def finish_recording(session_id):
    _session_or_404(session_id)
    storage.update_session(session_id, recording_finished=True, status="transcribing")
    pipeline.maybe_finish(session_id)
    return jsonify(_with_progress(storage.get_session(session_id)))


@app.post("/api/sessions/<session_id>/regenerate")
def regenerate(session_id):
    session = _session_or_404(session_id)
    if not session["recording_finished"]:
        abort(409, "Recording still in progress")
    pipeline.start_notes(session_id)
    return jsonify(storage.get_session(session_id))


@app.get("/api/sessions/<session_id>/transcript")
def transcript(session_id):
    _session_or_404(session_id)
    return storage.build_transcript(session_id), 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.get("/api/sessions/<session_id>/notes")
def notes(session_id):
    _session_or_404(session_id)
    path = storage.notes_path(session_id)
    if not path.exists():
        abort(404)
    return path.read_text(), 200, {"Content-Type": "text/markdown; charset=utf-8"}


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("\n  ⚠  ANTHROPIC_API_KEY is not set — recording and transcription will work,")
        print("     but notes can't be written until you set it. See README.md.\n")
    storage.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    pipeline.start()
    port = int(os.environ.get("PORT", "5000"))
    url = f"http://localhost:{port}"
    print(f"\n  🎲 Session Scribe is running at {url}\n")
    if not os.environ.get("NO_BROWSER"):
        webbrowser.open(url)
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=port, threaded=True)


if __name__ == "__main__":
    main()
