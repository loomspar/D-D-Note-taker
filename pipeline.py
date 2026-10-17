"""Background work: transcribing audio chunks as they arrive, and writing notes when a session ends."""

import os
import queue
import re
import shutil
import subprocess
import threading
import traceback

import anthropic
import av
import numpy as np

import storage
from notes import generate_notes

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en") or None
UPLOAD_SEGMENT_SECONDS = 600

_queue: "queue.Queue[tuple[str, int]]" = queue.Queue()
_model = None
_notes_running: set[str] = set()
_notes_lock = threading.Lock()
_model_lock = threading.Lock()


def _get_model():
    global _model
    with _model_lock:
        if _model is not None:
            return _model
        from faster_whisper import WhisperModel

        print(f"Loading Whisper '{WHISPER_MODEL}' model (first run downloads it)...")
        _model = WhisperModel(WHISPER_MODEL, device="auto", compute_type="int8")
        return _model


def _whisper_prompt() -> str | None:
    # Feeding campaign names to Whisper makes it far more likely to spell them right.
    context = storage.get_settings().get("campaign_context", "").strip()
    return f"A Dungeons & Dragons session. {context}"[:800] if context else "A Dungeons & Dragons session."


def _chunk_path(session_id: str, index: int):
    matches = list(storage.chunks_dir(session_id).glob(f"{index:04d}.*"))
    return matches[0] if matches else None


def _load_audio(path) -> np.ndarray:
    """Decode any audio file to 16 kHz mono float32, keeping whatever decodes cleanly.

    (faster-whisper's own loader breaks on newer PyAV releases, and browser recordings
    sometimes end with a truncated packet.)"""
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    pieces = []
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        try:
            for packet in container.demux(stream):
                for frame in packet.decode():
                    pieces.extend(f.to_ndarray() for f in resampler.resample(frame))
        except av.FFmpegError as e:
            print(f"Audio decode stopped early for {path}: {e}")
        pieces.extend(f.to_ndarray() for f in resampler.resample(None))
    if not pieces:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(pieces, axis=1).flatten().astype(np.float32) / 32768.0


def _transcribe(session_id: str, index: int) -> None:
    path = _chunk_path(session_id, index)
    if path is None:
        return
    try:
        audio = _load_audio(path)
        segments, _ = _get_model().transcribe(
            audio,
            language=WHISPER_LANGUAGE,
            vad_filter=True,
            initial_prompt=_whisper_prompt(),
        )
        data = {
            "duration": len(audio) / 16000,
            "segments": [
                {"start": s.start, "end": s.end, "text": s.text.strip()}
                for s in segments
                if s.text.strip()
            ],
        }
    except Exception as e:  # a corrupt or empty chunk shouldn't sink the whole session
        print(f"Could not transcribe chunk {index} of {session_id}: {e}")
        data = {"duration": 0, "segments": [], "error": str(e)}
    storage.save_chunk_transcript(session_id, index, data)


def _worker() -> None:
    while True:
        session_id, index = _queue.get()
        try:
            storage.get_session(session_id)  # skip work for deleted sessions
            _transcribe(session_id, index)
            maybe_finish(session_id)
        except KeyError:
            pass
        except Exception:
            traceback.print_exc()


def enqueue_chunk(session_id: str, index: int) -> None:
    _queue.put((session_id, index))


def maybe_finish(session_id: str) -> None:
    """Start writing notes once recording has ended and every chunk is transcribed."""
    session = storage.get_session(session_id)
    if not session["recording_finished"] or session["status"] in ("generating", "done", "error"):
        return
    expected = set(storage.chunk_indexes(session_id))
    if not expected <= storage.transcribed_indexes(session_id):
        return
    start_notes(session_id)


def start_notes(session_id: str) -> None:
    with _notes_lock:
        if session_id in _notes_running:
            return
        _notes_running.add(session_id)
    storage.update_session(session_id, status="generating", error=None)
    threading.Thread(target=_write_notes, args=(session_id,), daemon=True).start()


def _write_notes(session_id: str) -> None:
    try:
        transcript = storage.build_transcript(session_id)
        if not transcript.strip():
            raise RuntimeError("No speech was detected in the recording.")
        session = storage.get_session(session_id)
        context = storage.get_settings().get("campaign_context", "")
        notes = generate_notes(transcript, context, session["title"])
        storage.notes_path(session_id).write_text(notes)
        changes = {"status": "done"}
        heading = re.match(r"#\s+(.+)", notes)
        if heading and not session.get("title_set_by_user"):
            changes["title"] = heading.group(1).strip()
        storage.update_session(session_id, **changes)
    except KeyError:
        pass
    except Exception as e:
        traceback.print_exc()
        if isinstance(e, anthropic.AuthenticationError) or "authentication method" in str(e):
            message = "Your Anthropic API key is missing or invalid. Add it to the .env file (see README) and restart."
        elif isinstance(e, anthropic.APIConnectionError):
            message = "Couldn't reach Claude. Check your internet connection and try again."
        else:
            message = str(e)
        try:
            storage.update_session(session_id, status="error", error=message)
        except KeyError:
            pass
    finally:
        with _notes_lock:
            _notes_running.discard(session_id)


def process_upload(session_id: str, source_path) -> None:
    """Split an uploaded recording into 10-minute pieces and queue them for transcription."""

    def run():
        try:
            if not shutil.which("ffmpeg"):
                raise RuntimeError("ffmpeg is required to process uploaded recordings. Please install it.")
            out = storage.chunks_dir(session_id) / "%04d.flac"
            subprocess.run(
                ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(source_path),
                 "-vn", "-ac", "1", "-ar", "16000", "-f", "segment",
                 "-segment_time", str(UPLOAD_SEGMENT_SECONDS), str(out)],
                check=True, capture_output=True, text=True,
            )
            source_path.unlink(missing_ok=True)
            indexes = storage.chunk_indexes(session_id)
            if not indexes:
                raise RuntimeError("That file doesn't seem to contain any audio.")
            storage.update_session(
                session_id, status="transcribing", recording_finished=True, chunk_count=len(indexes)
            )
            for i in indexes:
                enqueue_chunk(session_id, i)
        except subprocess.CalledProcessError as e:
            storage.update_session(session_id, status="error", error=f"Couldn't read that audio file: {e.stderr.strip()[:300]}")
        except Exception as e:
            storage.update_session(session_id, status="error", error=str(e))

    threading.Thread(target=run, daemon=True).start()


def resume_pending_work() -> None:
    """After a restart, pick up any chunks or notes that were left unfinished."""
    for session in storage.list_sessions():
        sid = session["id"]
        if session["status"] == "generating":
            storage.update_session(sid, status="transcribing")
        done = storage.transcribed_indexes(sid)
        pending = [i for i in storage.chunk_indexes(sid) if i not in done]
        for i in pending:
            enqueue_chunk(sid, i)
        if not pending:
            maybe_finish(sid)


def start() -> None:
    threading.Thread(target=_worker, daemon=True).start()
    # Warm the model up in the background so the first chunk isn't slow.
    threading.Thread(target=_get_model, daemon=True).start()
    resume_pending_work()
