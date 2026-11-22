# 云栖 PMS 后端镜像（构建上下文 = backend/）
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# 先装依赖再拷代码，利用层缓存（PIP_INDEX_URL 可在构建时换国内源加速）
ARG PIP_INDEX_URL=https://pypi.org/simple
COPY requirements.txt ./
RUN pip install --no-cache-dir -i "${PIP_INDEX_URL}" -r requirements.txt

COPY app ./app

EXPOSE 8000
# 单 worker：ensure_seed 多 worker 会竞态双份种子（见 AGENTS.md 踩坑记录）
# --proxy-headers：nginx 反代后按 X-Forwarded-For 还原真实客户端 IP，登录/验证码限流按客户端计
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
