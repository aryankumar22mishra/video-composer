from rest_framework.routers import DefaultRouter
from django.urls import path
from .views import (AIAgentView, ComposeJobViewSet, ProjectViewSet,
                    AgentToolsView, AgentPlanView, AgentPrepareView, AgentExecuteView)

router = DefaultRouter()
router.register(r"jobs", ComposeJobViewSet, basename="compose-job")
router.register(r"projects", ProjectViewSet, basename="project")

urlpatterns = [
    path("ai/", AIAgentView.as_view(), name="ai-agent"),
    path("ai/tools/", AgentToolsView.as_view(), name="agent-tools"),
    path("ai/plan/", AgentPlanView.as_view(), name="agent-plan"),
    path("ai/media/prepare/", AgentPrepareView.as_view(), name="agent-media-prepare"),
    path("ai/media/execute/", AgentExecuteView.as_view(), name="agent-media-execute"),
] + router.urls
