from datetime import datetime
from zoneinfo import ZoneInfo

from mes_api.jobs import due_jobs

IST = ZoneInfo("Europe/Istanbul")   # UTC+3; bakım saati 02:00 yerel = 23:00 UTC


def test_first_run_everything_is_due():
    assert set(due_jobs(datetime(2026, 10, 19, 10), {}, IST, 2)) == {"telemetry_partitions", "telemetry_purge", "telemetry_compress", "auth_cleanup"}


def test_daily_jobs_wait_for_next_maintenance_window():
    ran = datetime(2026, 10, 18, 23, 5)   # 19 Ekim 02:05 yerel
    runs = {"telemetry_partitions": datetime(2026, 10, 19, 9, 30), "telemetry_purge": ran, "telemetry_compress": ran, "auth_cleanup": ran}
    # Aynı gün öğlen: günlükler beklemede, saatlik iş 30 dk önce çalıştı
    assert due_jobs(datetime(2026, 10, 19, 10), runs, IST, 2) == []
    # Saatlik iş 1 saat dolunca
    assert due_jobs(datetime(2026, 10, 19, 10, 31), runs, IST, 2) == ["telemetry_partitions"]
    # Ertesi gece 02:00 yerel geçince günlükler tekrar
    assert set(due_jobs(datetime(2026, 10, 19, 23, 1), runs, IST, 2)) == {"telemetry_partitions", "telemetry_purge", "telemetry_compress", "auth_cleanup"}
