# whale-ci
Continuous integration with docker containers

This runs CI jobs that are defined in docker containers. The containers 
are defined in a YAML file listing the various containers and their dockerfiles.

# configuration file

Example:

```yaml
build:
    dockerfile: ./Dockerfile.build

database:
    image: postgres
    service: true
    environment:
       POSTGRES_HOST_AUTH_METHOD: trust
    ports: 5432

test:
    dockerfile: ./Dockerfile.test
    depends:
      - build
      - database
    command: runtests

```

Each section is named container which has a docker file or a container name 
on the linked docker registry.

The valid keys in each section are:

* dockerfile: A path to a Docker file to build, relative to the yaml file
  locatiom. If the Dockerfile's first `FROM` instruction names another step that
  also builds from a `dockerfile`, that step's freshly-built image is used as the
  base image instead of being pulled from a registry, and an implicit dependency
  on that step is added (even without `depends`) so it is built first. For
  example, a `base` step building a common image and an `app` step whose
  Dockerfile starts `FROM base` will have `app` built on top of `base`. The
  base substitution is per-run, so several pipelines can build in parallel
  without clobbering one another's images.
* image: the image to pull if there is no docker file. If the value matches the
  name of another step that builds its own image (a step with a `dockerfile`),
  that step's generated image is used instead of pulling from the registry, and
  an implicit dependency on that step is added (even without `depends`).
  Otherwise the image is pulled from Docker Hub as usual.
* runtime: `docker` or `incus` (default `docker`). The container runtime the
  step runs under. A step with `runtime: incus` runs in an ephemeral [incus]
  (https://linuxcontainers.org/incus/) instance using the `incus` CLI, which is
  assumed to be installed and usable by the current user: the instance is
  launched from the step's `image` (an incus image reference such as
  `images:debian/12`), each command runs inside it with `incus exec` (the
  instance's filesystem persists between commands), and the instance is deleted
  when the step finishes. An incus step must use `image` — incus cannot build
  a `dockerfile` — and its image always refers to an incus image, never to
  another step's built image. Incus steps cannot be services and cannot depend
  on services, because there is no shared network between incus and docker
  steps (see "Networking between steps" below). They may otherwise depend on
  and be depended on by any non-service step, and `--max-concurrency` applies
  jointly across both runtimes.
* service: `true` or `false` (default `false`). A service runs in the background
  for as long as at least one other step still depends on it, and is stopped as
  soon as it is no longer required. A non-service runs its command to completion.
* depends: the name (or list of names) of other steps that must be ready before
  this step runs. A dependency that is a service must be running first; a
  dependency that is not a service must have completed first.
* command: the command to run inside the container. May be a single string or a
  list of strings. A list runs in order, stopping at the first command that
  exits non-zero (which fails the step). Each command runs through the image's
  entrypoint just like a single command would, and the container's filesystem is
  committed between commands so changes from one carry forward to the next. A
  service step may have at most one command.
* environment: environment variables for the container, given either as a
  mapping (`KEY: value`) or a list of `KEY=value` strings.
* disable: `true` or `false` (default `false`). When `true` the step is
  completely ignored: it is dropped from the pipeline and is never built, run,
  reported, or available as a dependency of other steps.
* only-if: a string. Evaluated as a bash command on the host just before the
  step would run (after its dependencies are ready). If the command exits
  non-zero the step is skipped: it is not built or run, and it is reported as
  skipped. A skipped step still counts as completed, so steps that depend on
  it run as usual — note that dependents of a skipped *service* will not find
  it running. The command's output is discarded.
* push: a mapping (only valid on a step with a `dockerfile`). After the step
  succeeds, its built image is pushed to Docker Hub. The push happens with the
  host's docker credentials, so `docker login` must already have been run.
  Subkeys:
  * image: the repository to push to, e.g. `myorg/myapp`. Required.
  * tag: the tag (or list of tags) to push as; defaults to `latest`. A list
    pushes the image once per tag, in order. Each value of the form
    `$(command)` is evaluated as a shell command on the host and its trimmed
    output becomes the tag (for example `tag: $(git rev-parse --short HEAD)`).
    If the command fails or prints nothing, the step fails.
  * only-if: a bash command evaluated on the host after the step succeeds. The
    image is pushed only when it exits zero; a non-zero exit skips the push
    without failing the step (useful to push only from a particular branch).

  ```yaml
  build:
      dockerfile: ./Dockerfile
      command: make test
      push:
          image: myorg/myapp
          tag:
            - latest
            - $(git rev-parse --short HEAD)
          only-if: test "$(git branch --show-current)" = main
  ```
* ready-on: a string (only valid on a service). Any step that depends on this
  service is held until this exact string appears in the service's output, so
  you can wait for a slow-starting service to finish booting (for example a
  database printing its "ready to accept connections" banner). If the service
  stops before the string appears, the step fails. The string is matched against
  the service's combined stdout and stderr.
* delay: a non-negative number of seconds. The step waits this long after all of
  its dependencies are ready, and before it runs.
* timeout-minutes: a positive number of minutes. If the step does not complete
  its execution within this many minutes it is aborted and the step fails. The
  `delay` does not count against this budget.
* quiet: `true` or `false` (default `false`). When `true` the step's output is
  not echoed to the terminal. It is still captured for the HTML report (when one
  is requested with `--output`), so you can keep a noisy step off the console
  without losing its log.

# Networking between steps

All docker steps run on a single Docker network, and each container is
reachable from the others by its **step name as a hostname**. To connect from one step to
another, use the target step's name as the host — typically through an
environment variable — and `depends` on it so it is started first:

```yaml
database:
    image: postgres
    service: true
    environment:
       POSTGRES_HOST_AUTH_METHOD: trust
    ready-on: ready to accept connections

app:
    dockerfile: ./Dockerfile.app
    depends:
      - database
    environment:
       DB_HOST: database     # the step name resolves to the database container
       DB_PORT: 5432
    command: run-migrations
```

Inside the `app` container, connecting to host `database` reaches the `database`
step's container. Use `depends` (and, for services that take a moment to start,
`ready-on`) so the service is up before the client tries to connect.

Steps with `runtime: incus` never join this network: there is **no shared
network between incus and docker steps**, which is why an incus step can
neither be a service nor depend on one.

# Command-line interface

whale-ci is run from npx. It takes a single argument, the name of the YML 
configuration file. It assumes docker is installed on the host machine.

`npx whale-ci ci.yml`

If no file is given it prints an error. If the argumnt is `--help` it prints a 
brief help message. It validates the input yaml file and prints an error if it does not
conform to the correct format.

If the file is valid, it builds all images, in parallel when possible (while respecting 
each step's dependencies). if any build or command returns an error, the test has failed 
and the overall command fails, with an error code of 1.

At the end, whether the test succeeded or not, all running containers are stopped.

## Options

* `-o`, `--output <file>`: write a self-contained HTML report to `<file>`. The
  report has one initially-closed accordion per step (services included) showing
  the step name, whether it passed or failed, its execution duration, and all of
  the captured build and container-run output.

`npx whale-ci -o report.html ci.yml`

* `--max-concurrency <n>`: the maximum number of test containers that run in
  parallel. The limit is shared jointly by docker and incus steps; service
  containers do not count toward it. Defaults to 4.

`npx whale-ci --max-concurrency 8 ci.yml`

* `--serve`: run as a CI server instead of running once. This starts an HTTP
  server that acts as the backend for a GitHub push webhook (see below).

`npx whale-ci --serve ci.yml`

# Server mode (GitHub webhook backend)

With `--serve`, whale-ci runs as a long-lived HTTP server that GitHub can call as
a [push webhook](https://docs.github.com/webhooks). The webhook is served on
the `/webhook` path (configure GitHub's payload URL as
`http://<host>:<port>/webhook`); requests to any other path get a `404`. Each
accepted push is built and tested, and the result is reported back to GitHub as
a commit status (so it shows up as a check on the commit and pull request).

The command must be run **from the root of a git checkout** that contains the
named config file; it refuses to start otherwise. Because several pushes (to
different branches) may be in flight at once, the server never builds in the
serving checkout itself. Instead, for each push it:

1. verifies the webhook's `X-Hub-Signature-256` against `WEBHOOK_SECRET`;
2. posts a `pending` commit status;
3. fetches the pushed branch and adds a detached **git worktree**, under
   `WORKTREE_ROOT`, checked out at the exact pushed commit;
4. loads the config file from that worktree and runs the pipeline there;
5. posts a `success` or `failure` (or `error`) commit status; and
6. removes the worktree.

Using a separate worktree per push lets pushes to different branches be tested
concurrently without interfering with each other.

The server is configured entirely through environment variables:

* `GITHUB_TOKEN`: token used to post commit statuses to the GitHub API.
* `WEBHOOK_SECRET`: shared secret used to verify webhook signatures. Requests
  with a missing or invalid signature are rejected with `401`.
* `WORKTREE_ROOT`: directory under which the per-push git worktrees are created
  (created if it does not exist).
* `LISTEN_PORT`: TCP port the webhook server listens on.

```sh
export GITHUB_TOKEN=ghp_...
export WEBHOOK_SECRET=$(openssl rand -hex 20)
export WORKTREE_ROOT=/var/tmp/whale-ci
export LISTEN_PORT=8080
npx whale-ci --serve ci.yml
```

`ping` events are answered, non-`push` events are ignored, and branch deletions
and tag pushes are skipped. Press Ctrl-C to stop the server; it waits for any
in-flight CI jobs to finish before exiting.