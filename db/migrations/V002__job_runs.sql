-- V002: Zamanlanmış bakım işlerinin son çalışma bilgisi (API içindeki zamanlayıcı yazar)
CREATE TABLE dbo.job_runs (
    job_name          varchar(64)     NOT NULL CONSTRAINT pk_job_runs PRIMARY KEY,
    last_started_at   datetime2(3)    NULL,
    last_finished_at  datetime2(3)    NULL,
    last_status       varchar(16)     NULL CONSTRAINT ck_job_runs_status CHECK (last_status IN ('running', 'success', 'failed')),
    last_message      nvarchar(2000)  NULL,
    last_duration_ms  int             NULL
);

INSERT INTO dbo.plant_settings ([key], value)
SELECT 'maintenance_hour_local', N'2'
WHERE NOT EXISTS (SELECT 1 FROM dbo.plant_settings WHERE [key] = 'maintenance_hour_local');
GO

-- Süresi dolmuş veya iptal edilip bir günden eski refresh token'ları siler.
CREATE PROCEDURE dbo.usp_auth_cleanup
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM dbo.user_refresh_tokens
    WHERE expires_at < SYSUTCDATETIME()
       OR (revoked_at IS NOT NULL AND revoked_at < DATEADD(DAY, -1, SYSUTCDATETIME()));
    SELECT @@ROWCOUNT AS deleted;
END
GO
