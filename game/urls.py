from django.urls import path
from . import views

urlpatterns = [
    path('create/', views.create_room, name='create_room'),
    path('join/', views.join_room, name='join_room'),
    path('room/<str:code>/', views.room, name='room'),
    path('api/toggle-easter-egg/', views.toggle_easter_egg, name='toggle_easter_egg'),
]
