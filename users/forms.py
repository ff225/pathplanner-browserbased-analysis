from django import forms
from .models import UserProfile, UserPreferences
import re

# Form for viewing/editing your profile
class UserProfileForm(forms.ModelForm):
    class Meta:
        model = UserProfile
        fields = ['first_name', 'last_name', 'email', 'default_pathology']

        labels = {
            'first_name': 'First name',
            'last_name': 'Last name',
            'email': 'Email',
            'preferences': 'Preferences',
            'default_pathology': 'Default clinical condition',
        }

        help_texts = {
            'default_pathology': 'This condition is pre-selected when you plan a route.',
        }

        widgets = {
            'default_pathology': forms.RadioSelect(),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Set fields as non-compulsory
        self.fields['first_name'].required = False
        self.fields['last_name'].required = False
        self.fields['email'].required = False
        self.fields['default_pathology'].required = False

        # Friendly placeholders
        self.fields['first_name'].widget.attrs['placeholder'] = 'Your first name'
        self.fields['last_name'].widget.attrs['placeholder'] = 'Your last name'
        self.fields['email'].widget.attrs['placeholder'] = 'your.email@example.com'

    # Method for checking the name
    def clean_first_name(self): 
        first_name = self.cleaned_data['first_name']
        if re.search(r'\d', first_name):
            raise forms.ValidationError("The name may not contain numbers.")
        return first_name

     # Method for checking the surname
    def clean_last_name(self):
        last_name = self.cleaned_data['last_name']
        if re.search(r'\d', last_name):
            raise forms.ValidationError("The surname may not contain numbers.")
        return last_name


# Form to display a user's preferences and allow them to modify it
class UserPreferencesForm(forms.ModelForm):
    class Meta:
        model = UserPreferences
        fields = [
            'name', 
            'nature',
            'entertainment',
            'tourism',
            'nightlife',

            # The following preferences are not yet implemented
            'avoid_highways', 
            'avoid_tolls', 
            'avoid_traffic', 
            'scenic_route', 
            'prefer_lit_routes', 
            'prefer_parks',
            'hospital'
        ]

        labels = {
            'name': 'Name',
            'nature': 'Nature (Viewpoint, lake ...)', 
            'entertainment': 'Entertainment (cinema, theatre ...)',
            'tourism': 'Tourism (monuments, attractions ...)',
            'nightlife': 'Nightlife (bar, nigthclub ...)',

            # The following preferences are not yet implemented
            'avoid_highways': 'Avoid Highways',
            'avoid_tolls': 'Avoid Tolls',
            'avoid_traffic': 'Avoid Traffic',
            'scenic_route': 'Scenic Route',
            'prefer_lit_routes': 'Prefer Lit Routes',
            'prefer_parks': 'Prefer Parks',
            'hospital': 'Hospital'
        }
        
        widgets = {
            'nature': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_nature'}),
            'entertainment': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_entertainment'}),
            'tourism': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_tourism'}),
            'nightlife': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_nightlife'}),
            'avoid_highways': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_avoid_highways'}),
            'avoid_tolls': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_avoid_tolls'}),
            'avoid_traffic': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_avoid_traffic'}),
            'scenic_route': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_scenic_route'}),
            'prefer_lit_routes': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_prefer_lit_routes'}),
            'prefer_parks': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_prefer_parks'}),
            'hospital': forms.NumberInput(attrs={'type': 'range', 'min': -1, 'max': 1, 'step': 0.5, 'id': 'id_hospital'}),
        }
