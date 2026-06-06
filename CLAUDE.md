# Project overview

This is the repository for docker-ci, a continuous integration system based
on linked docker containers. The command line interface is described in 
the README.md file.

# Directory structure

The project is implemented in Node.js, minimum version 22.18 (the first release
that runs TypeScript directly without a flag). All code uses TypeScript and ESM

* lib/ - most of the project code is available as a Node.js library, located here
* src/ - the code for the CLI command.
* tests/ - tests for the code in lib/, to run with the build-in node.js test runner

use npm imports to parse the config file
