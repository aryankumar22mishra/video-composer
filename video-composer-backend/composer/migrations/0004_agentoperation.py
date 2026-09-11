import uuid
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("composer", "0003_project")]
    operations = [migrations.CreateModel(
        name="AgentOperation",
        fields=[
            ("id", models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False, serialize=False)),
            ("run_id", models.UUIDField(db_index=True)),
            ("fingerprint", models.CharField(max_length=64)),
            ("tool", models.CharField(max_length=50)),
            ("arguments", models.JSONField(default=dict)),
            ("status", models.CharField(max_length=30, default="awaiting_confirmation")),
            ("result", models.JSONField(default=dict)),
            ("output", models.FileField(upload_to="agent/generated/", blank=True)),
            ("created_at", models.DateTimeField(auto_now_add=True)),
        ],
    )]
