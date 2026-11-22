# 云栖 PMS 前端镜像：两段构建 —— node 打包 → nginx 托管静态 + /api 反代
FROM node:22-alpine AS build

WORKDIR /app
# 构建期可注入：NPM_REGISTRY 换国内源；VITE_DEMO_HINT=off 隐藏登录页演示账号提示
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG VITE_DEMO_HINT=on
COPY package.json package-lock.json ./
RUN npm config set registry "${NPM_REGISTRY}" && npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# 开发辅助登录页（dev-login.html）不进生产镜像
RUN rm -f /usr/share/nginx/html/dev-login.html

EXPOSE 80
