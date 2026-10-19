FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY mes_api ./mes_api
RUN pip install --no-cache-dir --root-user-action=ignore .
USER nobody
EXPOSE 8000
CMD ["uvicorn", "mes_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--no-server-header"]
