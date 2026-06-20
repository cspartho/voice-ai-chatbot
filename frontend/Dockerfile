# Voice Agent frontend — build with Vite, serve with nginx (also reverse-proxies
# the API to the backend, so the whole app is one origin in production).

# --- Build stage ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
# Use `npm install` (not `npm ci`): Tailwind v4's native deps have
# platform-specific optional packages, and a lockfile generated on another OS
# (e.g. Windows) won't contain the Linux variants that `npm ci` strictly
# requires. `npm install` honours the lockfile but fills in the right binaries.
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# --- Serve stage ---
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
