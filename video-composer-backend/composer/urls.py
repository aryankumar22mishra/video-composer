from rest_framework.routers import DefaultRouter
from .views import ComposeJobViewSet, ProjectViewSet

router = DefaultRouter()
router.register(r"jobs", ComposeJobViewSet, basename="compose-job")
router.register(r"projects", ProjectViewSet, basename="project")

urlpatterns = router.urls