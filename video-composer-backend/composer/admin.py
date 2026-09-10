from django.contrib import admin
from .models import ComposeJob, Clip, Project

admin.site.register(ComposeJob)
admin.site.register(Clip)
admin.site.register(Project)