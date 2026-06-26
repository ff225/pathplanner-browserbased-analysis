from django.shortcuts import redirect
from django.views import View
from django.contrib.auth import login, logout
from django.contrib import messages
from django.urls import reverse_lazy
from django.contrib.auth.forms import UserCreationForm, AuthenticationForm
from django.contrib.auth.mixins import LoginRequiredMixin
from .models import UserProfile, UserPreferences
from .forms import UserProfileForm, UserPreferencesForm
from core.views import CustomRequired, AddItemView, EditItemView, DeleteItemView, UpdateView
from django.views.generic import ListView
from django.views.generic.edit import FormView
from django.http import JsonResponse
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_GET

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

    def get_success_url(self):
        next_url = self.request.POST.get('next') or self.request.GET.get('next')
        if next_url:
            return next_url
        return super().get_success_url()

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
class EditProfileView(LoginRequiredMixin, UpdateView):
    model = UserProfile
    form_class = UserProfileForm
    template_name = 'edit_profile.html'
    success_url = reverse_lazy('users:profile')
    success_message = 'Profile successfully updated!'

    # Get current user profile
    def get_object(self):
        return self.request.user.userprofile

    def get_initial(self):
        initial = super().get_initial()
        user = self.request.user
        initial['first_name'] = user.first_name
        initial['last_name'] = user.last_name
        initial['email'] = user.email
        return initial

    def form_valid(self, form):
        # Sync the Django user account with the profile form
        user = self.request.user
        user.first_name = form.cleaned_data.get('first_name', '')
        user.last_name = form.cleaned_data.get('last_name', '')
        user.email = form.cleaned_data.get('email', '')
        user.save()

        response = super().form_valid(form)
        messages.success(self.request, self.success_message)
        return response


PREFERENCE_WEIGHT_FIELDS = ('nature', 'entertainment', 'nightlife', 'tourism', 'hospital')


def safe_next_url(request):
    next_url = request.POST.get('next') or request.GET.get('next')
    if next_url and url_has_allowed_host_and_scheme(
        next_url,
        allowed_hosts={request.get_host()},
        require_https=request.is_secure()
    ):
        return next_url
    return None


class PreferenceReturnMixin:
    def get_success_url(self):
        return safe_next_url(self.request) or super().get_success_url()

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context['next_url'] = safe_next_url(self.request) or reverse_lazy('users:profile')
        return context


class UserPreferenceQuerysetMixin:
    def get_queryset(self):
        return self.request.user.userprofile.preferences.all()


@require_GET
def preference_weights(request, userpreferences_id):
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'Authentication required'}, status=403)

    try:
        preference = request.user.userprofile.preferences.get(pk=userpreferences_id)
    except (UserProfile.DoesNotExist, UserPreferences.DoesNotExist):
        return JsonResponse({'error': 'Preference not found'}, status=404)

    data = {
        'id': preference.id,
        'name': preference.name or '',
    }
    data.update({
        field: float(getattr(preference, field))
        for field in PREFERENCE_WEIGHT_FIELDS
    })
    return JsonResponse(data)


# Class based view to add a preference set
class AddSetView(PreferenceReturnMixin, AddItemView):
    model = UserPreferences
    form_class = UserPreferencesForm
    template_name = 'add_preferences.html'
    success_message = 'Set successfully added!'

# Class based view to modify a preference set
class EditSetView(PreferenceReturnMixin, UserPreferenceQuerysetMixin, EditItemView):
    model = UserPreferences
    form_class = UserPreferencesForm
    template_name = 'edit_preferences.html'
    success_message = 'Set successfully modified!'
    pk_url_kwarg = 'userpreferences_id'

# Class based view to delete a preference set
class DeleteSetView(PreferenceReturnMixin, UserPreferenceQuerysetMixin, DeleteItemView):
    model = UserPreferences
    success_message = 'Set successfully eliminated!'
    pk_url_kwarg = 'userpreferences_id'

    def post(self, *args, **kwargs):
        obj = self.get_object()
        obj.delete()
        messages.success(self.request, self.success_message)
        return redirect(self.get_success_url())
