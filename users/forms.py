from django import forms
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import User
from .models import UserProfile, UserPreferences
import re


class ClinicalSignupForm(UserCreationForm):
    first_name = forms.CharField(label='First name', max_length=30, required=True)
    last_name = forms.CharField(label='Last name', max_length=30, required=True)
    email = forms.EmailField(label='Email', required=True)
    default_pathology = forms.ChoiceField(
        label='Default clinical condition',
        choices=UserProfile._meta.get_field('default_pathology').choices,
        required=False,
        initial='none',
        help_text='You can change this later from your profile.',
        widget=forms.RadioSelect(),
    )

    class Meta(UserCreationForm.Meta):
        model = User
        fields = ('username', 'first_name', 'last_name', 'email', 'default_pathology', 'password1', 'password2')

    def clean_first_name(self):
        first_name = self.cleaned_data['first_name']
        if re.search(r'\d', first_name):
            raise forms.ValidationError("The name may not contain numbers.")
        return first_name

    def clean_last_name(self):
        last_name = self.cleaned_data['last_name']
        if re.search(r'\d', last_name):
            raise forms.ValidationError("The surname may not contain numbers.")
        return last_name

    def clean_email(self):
        email = self.cleaned_data['email']
        if User.objects.filter(email__iexact=email).exists():
            raise forms.ValidationError("An account with this email already exists.")
        return email

    def save(self, commit=True):
        user = super().save(commit=False)
        user.first_name = self.cleaned_data['first_name']
        user.last_name = self.cleaned_data['last_name']
        user.email = self.cleaned_data['email']
        if commit:
            user.save()
            profile = user.userprofile
            profile.first_name = user.first_name
            profile.last_name = user.last_name
            profile.email = user.email
            profile.default_pathology = self.cleaned_data.get('default_pathology') or 'none'
            profile.save()
        return user

# Form for viewing/editing your profile
class UserProfileForm(forms.ModelForm):
    class Meta:
        model = UserProfile
        fields = ['first_name', 'last_name', 'email', 'profile_picture', 'default_pathology']

        labels = {
            'first_name': 'First name',
            'last_name': 'Last name',
            'email': 'Email',
            'profile_picture': 'Profile picture',
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
        self.fields['profile_picture'].required = False
        self.fields['default_pathology'].required = False

        # Friendly placeholders
        self.fields['first_name'].widget.attrs['placeholder'] = 'Your first name'
        self.fields['last_name'].widget.attrs['placeholder'] = 'Your last name'
        self.fields['email'].widget.attrs['placeholder'] = 'your.email@example.com'
        self.fields['email'].disabled = True
        self.fields['email'].help_text = 'Email changes are disabled for now. Password/email reset will be added separately.'
        self.fields['profile_picture'].help_text = 'Upload a square image if possible; it will be cropped into a circular avatar.'

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

    def clean_email(self):
        if self.instance and getattr(self.instance, 'user', None):
            return self.instance.user.email
        return self.cleaned_data.get('email', '')


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
            'hospital'
        ]

        labels = {
            'name': 'Name',
            'nature': 'Parks and green areas',
            'entertainment': 'Entertainment',
            'tourism': 'Tourism and landmarks',
            'nightlife': 'Nightlife',
            'hospital': 'Medical access'
        }
        
        widgets = {
            'nature': forms.NumberInput(attrs={'type': 'range', 'min': 0, 'max': 10, 'step': 1, 'id': 'id_nature', 'class': 'preference-slider'}),
            'entertainment': forms.NumberInput(attrs={'type': 'range', 'min': 0, 'max': 10, 'step': 1, 'id': 'id_entertainment', 'class': 'preference-slider'}),
            'tourism': forms.NumberInput(attrs={'type': 'range', 'min': 0, 'max': 10, 'step': 1, 'id': 'id_tourism', 'class': 'preference-slider'}),
            'nightlife': forms.NumberInput(attrs={'type': 'range', 'min': 0, 'max': 10, 'step': 1, 'id': 'id_nightlife', 'class': 'preference-slider'}),
            'hospital': forms.NumberInput(attrs={'type': 'range', 'min': 0, 'max': 10, 'step': 1, 'id': 'id_hospital', 'class': 'preference-slider'}),
        }
