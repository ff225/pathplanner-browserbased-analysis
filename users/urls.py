from django.urls import path
from .views import (
    SignupView,
    LoginView,
    LogoutView,
    ViewProfileView,
    EditProfileView,
    AddSetView,
    EditSetView,
    DeleteSetView,
    preference_weights,
)

app_name = 'users'

urlpatterns = [
    path('signup/', SignupView.as_view(), name="signup"),
    path('login/', LoginView.as_view(), name="login"),
    path('logout/', LogoutView.as_view(), name='logout'),
    path('profile/', ViewProfileView.as_view(), name="profile"), 
    path('profile/edit/', EditProfileView.as_view(), name='edit_profile'),
    path('profile/add_set/', AddSetView.as_view(), name='add_set'),
    path('profile/edit_set/<int:userpreferences_id>/', EditSetView.as_view(), name='edit_set'),
    path('profile/delete_set/<int:userpreferences_id>/', DeleteSetView.as_view(), name='delete_set'),
    path('profile/preferences/<int:userpreferences_id>/weights/', preference_weights, name='preference_weights'),
]
