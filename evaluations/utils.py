from .models import Hospital, Stazione  # Assuming you have these models
from geopy.distance import geodesic

# ...existing code...

def calculate_route(start_location, end_location, preferences):
    # Logic to calculate the route based on preferences
    route = [start_location]

    # Add logic to include points of interest based on preferences
    if preferences.get('hospital', 0) > 0:
        nearest_hospital = find_nearest_hospital(start_location)
        if nearest_hospital:
            route.append(nearest_hospital)

    if preferences.get('nature', 0) > 0:
        nearest_nature_spot = find_nearest_nature_spot(start_location)
        if nearest_nature_spot:
            route.append(nearest_nature_spot)

    if preferences.get('entertainment', 0) > 0:
        nearest_entertainment_spot = find_nearest_entertainment_spot(start_location)
        if nearest_entertainment_spot:
            route.append(nearest_entertainment_spot)

    if preferences.get('tourism', 0) > 0:
        nearest_tourism_spot = find_nearest_tourism_spot(start_location)
        if nearest_tourism_spot:
            route.append(nearest_tourism_spot)

    if preferences.get('nightlife', 0) > 0:
        nearest_nightlife_spot = find_nearest_nightlife_spot(start_location)
        if nearest_nightlife_spot:
            route.append(nearest_nightlife_spot)

    route.append(end_location)
    return route

def find_nearest_hospital(location):
    # Logic to find the nearest hospital to the given location
    hospitals = Hospital.objects.all()
    return find_nearest_location(location, hospitals)

def find_nearest_nature_spot(location):
    # Logic to find the nearest nature spot to the given location
    nature_spots = Stazione.objects.filter(nature__gt=0)
    return find_nearest_location(location, nature_spots)

def find_nearest_entertainment_spot(location):
    # Logic to find the nearest entertainment spot to the given location
    entertainment_spots = Stazione.objects.filter(entertainment__gt=0)
    return find_nearest_location(location, entertainment_spots)

def find_nearest_tourism_spot(location):
    # Logic to find the nearest tourism spot to the given location
    tourism_spots = Stazione.objects.filter(tourism__gt=0)
    return find_nearest_location(location, tourism_spots)

def find_nearest_nightlife_spot(location):
    # Logic to find the nearest nightlife spot to the given location
    nightlife_spots = Stazione.objects.filter(nightlife__gt=0)
    return find_nearest_location(location, nightlife_spots)

def find_nearest_location(location, locations):
    # Generalized logic to find the nearest location from a list of locations
    nearest_location = None
    min_distance = float('inf')

    for loc in locations:
        loc_coords = (loc.lat, loc.lng)
        distance = geodesic(location, loc_coords).kilometers
        if distance < min_distance:
            min_distance = distance
            nearest_location = loc_coords

    return nearest_location

# ...existing code...
