# Automatic HTTPS in front of the backend (compose profile "caddy").
# Pinned by digest; the config is baked in so no host file is bind-mounted.
FROM caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f
COPY Caddyfile /etc/caddy/Caddyfile
