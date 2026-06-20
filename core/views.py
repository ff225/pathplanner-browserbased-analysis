from django.contrib import messages
from django.conf import settings
from django.shortcuts import redirect, render
from django.views.generic import TemplateView
from django.contrib.auth.mixins import AccessMixin
from django.views.generic.edit import UpdateView, CreateView, DeleteView
from django.urls import reverse_lazy
from django.http import Http404

# Class-based view to render the home page
class HomePage(TemplateView):
    template_name = 'homePage.html'

# Class-based view to render the map
class MapView(TemplateView):
    template_name = 'map.html'

    # Method to obtain user preferences
    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        user = self.request.user
        if user.is_authenticated:
            context['user_preferences'] = user.userprofile.preferences.all()
        context['benchmark_mode'] = self.request.GET.get('benchmark') == '1'
        context['mapbox_access_token'] = settings.MAPBOX_ACCESS_TOKEN
        return context


# Class for managing authorisations
class CustomRequired(AccessMixin):

    # Method handling view initialisation logic and pre-checking
    def dispatch(self, request, *args, **kwargs):
        if not request.user.is_authenticated:
            return not_authorized(request)
        
        return super().dispatch(request, *args, **kwargs)


# Function to render page 404
def custom_404_view(request):
    return render(request, '404.html', status=404)


# Function to render page 403
def not_authorized(request):
    return render(request, 'not_authorized.html', status=403)


# Class based view to render templates related to the addition of objects
class AddItemView(CustomRequired, CreateView):
    template_name = ''
    success_url = reverse_lazy('users:profile')
    success_message = ''

    # Method called when form data is valid
    def form_valid(self, form): 
        response = super().form_valid(form)
        # Associa l'oggetto creato al profilo dell'utente
        if hasattr(self.object, 'userprofile_set'):
            profile = self.request.user.userprofile
            profile.preferences.add(self.object)
            profile.save()
        messages.success(self.request, self.success_message)
        return response


# Class based view to render templates related to editing objects
class EditItemView(CustomRequired, UpdateView):
    template_name = ''
    success_url = reverse_lazy('users:profile')
    success_message = ''

    # Method called when form data is valid
    def form_valid(self, form):
        response = super().form_valid(form)
        messages.success(self.request, self.success_message)
        return response
    
    # Method handling view initialisation logic and pre-checking
    def dispatch(self, *args, **kwargs):
        try:
            return super().dispatch(*args, **kwargs)
        except Http404:
            return custom_404_view(self.request)


# Class based view to render templates related to the removal of objects
class DeleteItemView(CustomRequired, DeleteView):
    success_url = reverse_lazy('users:profile')
    success_message = ''

    # Method handling the logic of object deletion and redirection
    def post(self, *args, **kwargs):
        obj = self.get_object()
        obj.delete()
        messages.success(self.request, self.success_message)
        return redirect(self.success_url)
    
    # Method handling view initialisation logic and pre-checking
    def dispatch(self, *args, **kwargs):
        try:
            return super().dispatch(*args, **kwargs)
        except Http404:
            return custom_404_view(self.request)
