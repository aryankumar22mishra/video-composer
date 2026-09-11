from rest_framework.routers import DefaultRouter
from django.urls import path
from .views import AIAgentView, ComposeJobViewSet, ProjectViewSet

router = DefaultRouter()
router.register(r"jobs", ComposeJobViewSet, basename="compose-job")
router.register(r"projects", ProjectViewSet, basename="project")

urlpatterns = [path("ai/", AIAgentView.as_view(), name="ai-agent")] + router.urls