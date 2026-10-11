# Presentation site: one static page served by nginx.
# To publish a new version, change the folder copied below.
FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY v4/ /usr/share/nginx/html/
