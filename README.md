# dock-ci
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

* dockerfile: A path to a Docker file to build, relative to the yaml file locatiom
* image: the image to pull if there is no docker file
* service: `true` or `false` (default `false`). A service runs in the background
  for as long as at least one other step still depends on it, and is stopped as
  soon as it is no longer required. A non-service runs its command to completion.
* depends: the name (or list of names) of other steps that must be ready before
  this step runs. A dependency that is a service must be running first; a
  dependency that is not a service must have completed first.
* command: the command to run inside the container.
* environment: environment variables for the container, given either as a
  mapping (`KEY: value`) or a list of `KEY=value` strings.

# Command-line interface

dock-ci is run from npx. It takes a single argument, the name of the YML 
configuration file. It assumes docker is installed on the host machine.

`npx dock-ci ci.yml`

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

`npx dock-ci -o report.html ci.yml`