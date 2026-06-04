# dockerci
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
    volumes: 
       - "pgdata:/var/lib/postgresql/data"
    ports: 5432

test:
    dockerfile: ./Dockerfile.test
    build_depends: 
      - build
    depends:
      - database
    command: runtests

```

Each section is named container which has a docker file or a container name 
on the linked docker registry.

The valid keys in each section are:

* dockerfile: A path to a Docker file to build, relative to the yaml file locatiom
* image: the image to pull if there is no docker file
* build_depends: this is the name of another step, it must be built first. 
* depends: this container must be built and running before this image can run
* command: the command to run inside the container.

# Command-line interface

Dockerci is run from npx. It takes a single argument, the name of the YML 
configuration file. It assumes docker is installed on the host machine.

`npx dockerci ci.yml`

If no file is given it prints an error. If the argumnt is `--help` it prints a 
brief help message. It validates the input yaml file and prints an error if it does not
conform to the correct format.

If the file is valid, it builds all images, in parallel when possible (while respecting 
each step's dependencies). if any build or command returns an error, the test has failed 
and the overall command fails, with an error code of 1.

At the end, whether the test succeeded or not, all running containers are stopped.