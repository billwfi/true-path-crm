# True Path CRM — Python pipelines image (Container Apps Jobs).
# Runs the client SFTP import + reconcile pipeline (and other scripts/).
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive ACCEPT_EULA=Y PYTHONUNBUFFERED=1

# Microsoft ODBC Driver 17 for SQL Server (scripts use "ODBC Driver 17").
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl gnupg ca-certificates apt-transport-https unixodbc-dev \
 && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
        | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
 && curl -fsSL https://packages.microsoft.com/config/debian/12/prod.list \
        -o /etc/apt/sources.list.d/mssql-release.list \
 && apt-get update && apt-get install -y --no-install-recommends msodbcsql17 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deploy/jobs/requirements-jobs.txt .
RUN pip install --no-cache-dir -r requirements-jobs.txt

COPY scripts ./scripts

# Default: run the client pipeline wrapper (client + flags come from env vars).
CMD ["sh", "/app/scripts/client_imports/run_client_pipeline.sh"]
