# python-todo

A small [Flask](https://flask.palletsprojects.com/) TODO API tested end to end
against a real PostgreSQL database.

## Pipeline ([`ci.yml`](./ci.yml))

| step       | kind            | what it does                                              |
| ---------- | --------------- | -------------------------------------------------------- |
| `database` | service         | stock `postgres:16-alpine` image, trust auth via `environment` |
| `web`      | service         | the Flask app ([`Dockerfile`](./Dockerfile)), depends on `database` |
| `test`     | job             | curls the API ([`test.sh`](./test.sh)), depends on `web`  |

`web` reaches Postgres at `database:5432` and `test` reaches the app at
`web:8000` — each step is addressable by its name on the pipeline's docker
network.

## API ([`app.py`](./app.py))

* `GET /health` — readiness probe
* `GET /todos` — list todos
* `POST /todos` — create a todo from `{"title": "...", "done": false}`

The table is created on startup, and the app retries until Postgres is ready.

## Run it

From this directory:

```sh
npx dockerci ci.yml
# or, from a checkout of this repo:
node ../../src/cli.ts ci.yml

# write an HTML report of every step (build output, pass/fail, duration):
node ../../src/cli.ts -o report.html ci.yml
```

The run exits `0` when the API successfully writes and reads back a TODO item.
