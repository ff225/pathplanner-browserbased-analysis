from django.urls import path
from .views import (
    stazioni_dati,
    get_preferences,
    get_air_quality_data,
    get_environmental_data,
    get_real_environment_data,
    get_parks_in_bbox,
    get_env_score,
    optimized_route,
    astar_route,
    shortest_route,
    calculate_custom_route,
)

app_name = 'evaluations'

urlpatterns = [
    path('stazioni_dati/', stazioni_dati, name='stazioni_dati'),
    path('get_preferences/<int:preference_id>/', get_preferences, name='get_preferences'),
    path('air_quality/', get_air_quality_data, name='air_quality'),
    path('environment', get_real_environment_data, name='environment_no_slash'),
    path('environment/', get_real_environment_data, name='environment'),
    path('environmental_data/', get_environmental_data, name='environmental_data'),
    path('parks', get_parks_in_bbox, name='parks_no_slash'),
    path('parks/', get_parks_in_bbox, name='parks'),
    path('env_score/', get_env_score, name='env_score'),
    path('optimized_route/', optimized_route, name='optimized_route'),
    path('astar_route/', astar_route, name='astar_route'),
    path('shortest_route/', shortest_route, name='shortest_route'),
    path('custom_route/<int:preference_id>/', calculate_custom_route, name='custom_route'),
]
