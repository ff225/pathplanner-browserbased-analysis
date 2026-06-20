from django.db.models.signals import post_save
from django.dispatch import receiver
from django.contrib.auth.models import User
from .models import UserProfile

# Uses a Django signal to automatically create a user profile (UserProfile)
# each time a new user (User) is created. It also saves the existing user profile
# each time the user is saved. This ensures that each user has an associated profile
# and that the profile is updated when the user is updated

@receiver(post_save, sender=User)
def create_user_profile(sender, instance, created, **kwargs):
    if created:
        UserProfile.objects.create(user=instance)
    else:
        instance.userprofile.save()