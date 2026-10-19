FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY simulator ./simulator
RUN pip install --no-cache-dir .
COPY machines.yaml ./
USER nobody
CMD ["python", "-I", "-m", "simulator.main", "--config", "/app/machines.yaml"]
