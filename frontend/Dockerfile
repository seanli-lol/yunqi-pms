# 云栖 PMS 前端镜像：两段构建 —— node 打包 → nginx 托管静态 + /api 反代
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# 开发辅助登录页（dev-login.html）不进生产镜像
RUN rm -f /usr/share/nginx/html/dev-login.html

EXPOSE 80
