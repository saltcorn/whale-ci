"""A tiny TODO API backed by PostgreSQL.

Routes:
  GET  /health  -> {"status": "ok"}
  GET  /todos   -> list every todo
  POST /todos   -> create a todo from JSON {"title": ..., "done": false}
"""

import os
import time

import psycopg
from flask import Flask, jsonify, request

DB_HOST = os.environ.get("DB_HOST", "database")
DB_NAME = os.environ.get("DB_NAME", "postgres")
DB_USER = os.environ.get("DB_USER", "postgres")


def get_conn():
    """Open a new autocommit connection to the database."""
    return psycopg.connect(
        host=DB_HOST, dbname=DB_NAME, user=DB_USER, autocommit=True
    )


def init_db():
    """Wait for the database to accept connections, then create the table."""
    last_error = None
    for attempt in range(30):
        try:
            with get_conn() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS todos (
                        id    SERIAL PRIMARY KEY,
                        title TEXT NOT NULL,
                        done  BOOLEAN NOT NULL DEFAULT FALSE
                    )
                    """
                )
            print(f"database ready after {attempt + 1} attempt(s)", flush=True)
            return
        except Exception as error:  # noqa: BLE001 - retry on any startup error
            last_error = error
            print(f"waiting for database... ({error})", flush=True)
            time.sleep(1)
    raise RuntimeError(f"database never became ready: {last_error}")


app = Flask(__name__)
init_db()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/todos")
def list_todos():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, title, done FROM todos ORDER BY id")
        rows = cur.fetchall()
    return jsonify(
        [{"id": r[0], "title": r[1], "done": r[2]} for r in rows]
    )


@app.post("/todos")
def add_todo():
    data = request.get_json(force=True)
    title = data["title"]
    done = bool(data.get("done", False))
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO todos (title, done) VALUES (%s, %s) RETURNING id",
            (title, done),
        )
        new_id = cur.fetchone()[0]
    return jsonify({"id": new_id, "title": title, "done": done}), 201


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
