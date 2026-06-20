from django.db import models
from django.contrib.auth.models import User

PATHOLOGY_CHOICES = [
    ('none', 'No specific condition'),
    ('respiratory', 'Respiratory condition'),
    ('cardiac', 'Cardiac condition'),
    ('arthritis', 'Arthritis or joint pain'),
    ('mental', 'Mental health'),
    ('mobility', 'Limited mobility'),
    ('diabetes', 'Diabetes'),
]


# Class representing an object of type "UserPreferences"
class UserPreferences(models.Model):
    name = models.CharField(max_length=50, null=True)
    nightlife = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])
    tourism = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])
    entertainment = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])
    nature = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])
    
    # The following preferences are not yet implemented
    avoid_highways = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])
    avoid_tolls = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])
    avoid_traffic = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])
    scenic_route = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])
    prefer_lit_routes = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])
    prefer_parks = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])
    hospital = models.FloatField(default=0, choices=[(-1, 'Strongly against'), (-0.5, 'Against'), (0, 'Neutral'), (0.5, 'In favor'), (1, 'Strongly in favor')])

    def __str__(self):
        return self.name


# Class representing an object of type "UserProfile"
class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE)
    first_name = models.CharField(max_length=30)
    last_name = models.CharField(max_length=30)
    email = models.EmailField()
    profile_picture = models.ImageField(upload_to='static/uploaded_profile_pictures/', blank=True, null=True)
    preferences = models.ManyToManyField(UserPreferences, blank=True)
    default_pathology = models.CharField(
        max_length=20,
        choices=PATHOLOGY_CHOICES,
        default='none',
        help_text='Default clinical condition pre-selected when planning a route.'
    )

    def __str__(self):
        return self.user.username
