# nginx-hello

The smallest dockerci example: a static site served by nginx.

* `web` builds [`Dockerfile`](./Dockerfile) (nginx serving [`index.html`](./index.html)
  on port 8080) and runs as a background **service**.
* `test` pulls `curlimages/curl` and fetches `http://web:8080/`, reaching the
  `web` service by its step name over the pipeline's docker network. The build
  fails if the page can't be loaded.

Run it from this directory:

```sh
npx dockerci ci.yml
# or, from a checkout of this repo:
node ../../src/cli.ts ci.yml

# write an HTML report of every step:
node ../../src/cli.ts -o report.html ci.yml
```
