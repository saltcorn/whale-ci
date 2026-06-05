FROM nginx:alpine

# Serve our own page on port 8080 (replacing the image's default :80 site).
COPY default.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html

EXPOSE 8080
