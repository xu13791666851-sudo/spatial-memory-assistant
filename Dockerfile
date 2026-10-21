FROM node:22-bookworm-slim AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts/ scripts/
COPY web/ web/
COPY src/static/ src/static/
COPY netlify/ netlify/
COPY models/ models/
COPY android/app/src/main/assets/ android/app/src/main/assets/
RUN npm run build:demo

FROM python:3.11-slim-bookworm
WORKDIR /app
COPY demo/requirements.txt /app/demo/requirements.txt
RUN pip install --no-cache-dir -r demo/requirements.txt
COPY demo/ /app/demo/
COPY models/yolo/ /app/models/yolo/
COPY --from=ui /app/.demo-site /app/.demo-site
RUN useradd --create-home --uid 1000 demo && mkdir -p /mnt/workspace/iseeyou && chown -R demo:demo /mnt/workspace /app
USER demo
ENV DEMO_DATA_DIR=/mnt/workspace/iseeyou PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["python","-m","uvicorn","demo.server:app","--host","0.0.0.0","--port","7860","--proxy-headers"]
