from rest_framework.routers import DefaultRouter
from .views import ComposeJobViewSet

router = DefaultRouter()
router.register(r"jobs", ComposeJobViewSet, basename="compose-job")

urlpatterns = router.urls