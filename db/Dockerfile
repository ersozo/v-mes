FROM python:3.12-slim
RUN pip install --no-cache-dir pymssql==2.4.4
WORKDIR /db
# /db dizini compose tarafından salt okunur olarak bağlanır
CMD ["python", "-I", "/db/migrate.py"]
