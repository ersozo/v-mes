FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY mes_api ./mes_api
RUN pip install --no-cache-dir --root-user-action=ignore .
USER nobody
# 3. aşamada FastAPI sunucusu ile değiştirilecek
CMD ["python", "-I", "-m", "mes_api.flows.cli", "--help"]
