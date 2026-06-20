from django.shortcuts import redirect
from django.views import View
from django.contrib.auth import login, logout
from django.contrib import messages
from django.urls import reverse_lazy
from django.contrib.auth.forms import UserCreationForm, AuthenticationForm
from .models import UserProfile, UserPreferences
from .forms import UserProfileForm, UserPreferencesForm
from core.views import CustomRequired, AddItemView, EditItemView, DeleteItemView, UpdateView
from django.views.generic import ListView
from django.views.generic.edit import FormView

# Class based view to manage user registration logics
class SignupView(FormView):
    form_class = UserCreationForm
    template_name = 'signup.html'
    success_url = reverse_lazy('map')
    success_message = 'Registration successful. Welcome, you are logged in automatically.'

    def form_valid(self, form):
        user = form.save()
        login(self.request, user)
        messages.success(self.request, self.success_message)
        return super().form_valid(form)


# Class based view to manage user login logics
class LoginView(FormView):
    form_class = AuthenticationForm
    template_name = 'login.html'
    success_url = reverse_lazy('map')
    success_message = 'Successfully logged in. Welcome back!'

    def form_valid(self, form):
        user = form.get_user()
        login(self.request, user)
        messages.success(self.request, self.success_message)
        return super().form_valid(form)
    

# Class based view to manage user logout logics
class LogoutView(View):
    def post(self, request):
        if request.user.is_authenticated:
            logout(request)
            messages.success(request, 'Logout successfully executed.')
        else:
            messages.error(request, 'You must first login in order to logout.')
        return redirect(reverse_lazy('home'))   
    

# Class based view to manage user profile display logic
class ViewProfileView(CustomRequired, ListView):
    model = UserPreferences
    template_name = 'profile.html'
    paginate_by = 5

    def get_queryset(self):
        profile = self.request.user.userprofile
        return profile.preferences.all()

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context['profile'] = self.request.user.userprofile
        return context


# Class based view for editing your profile
class EditProfileView(CustomRequired, UpdateView):
    model = UserProfile
    form_class = UserProfileForm
    template_name = 'edit_profile.html'
    success_url = reverse_lazy('users:profile')
    success_message = 'Profile successfully updated!'

    # Get current user profile
    def get_object(self):
        return self.request.user.userprofile

    def form_valid(self, form):
        # Add success message and save profile
        response = super().form_valid(form)
        messages.success(self.request, self.success_message)
        return response

    
# Class based view to add a preference set
class AddSetView(AddItemView):
    model = UserPreferences
    form_class = UserPreferencesForm
    template_name = 'add_preferences.html'
    success_message = 'Set successfully added!'

# Class based view to modify a preference set
class EditSetView(EditItemView):
    model = UserPreferences
    form_class = UserPreferencesForm
    template_name = 'edit_preferences.html'
    success_message = 'Set successfully modified!'
    pk_url_kwarg = 'userpreferences_id'

# Class based view to delete a preference set
class DeleteSetView(DeleteItemView):
    model = UserPreferences
    success_message = 'Set successfully eliminated!'
    pk_url_kwarg = 'userpreferences_id'
    