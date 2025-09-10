from django.urls import re_path
from .consumers import RoomConsumer

websocket_urlpatterns = [
    re_path(r"ws/room/(?P<room_code>\w{4,8})/$", RoomConsumer.as_asgi()),
]
