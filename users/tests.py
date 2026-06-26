from django.contrib.auth.models import User
from django.test import TestCase
from django.urls import reverse

from .models import UserPreferences


PREFERENCE_FORM_DATA = {
    'name': 'Low noise route',
    'nature': '1',
    'entertainment': '-0.5',
    'tourism': '0.5',
    'nightlife': '-1',
    'avoid_highways': '0',
    'avoid_tolls': '0',
    'avoid_traffic': '0',
    'scenic_route': '0',
    'prefer_lit_routes': '0',
    'prefer_parks': '0',
    'hospital': '0.5',
}


class PreferenceMapTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='owner', password='password')
        self.other_user = User.objects.create_user(username='other', password='password')
        self.preference = UserPreferences.objects.create(
            name='Real saved weights',
            nature=1,
            entertainment=-0.5,
            tourism=0.5,
            nightlife=-1,
            hospital=0.5,
        )
        self.user.userprofile.preferences.add(self.preference)
        self.other_preference = UserPreferences.objects.create(name='Other user weights')
        self.other_user.userprofile.preferences.add(self.other_preference)

    def test_preference_weights_endpoint_returns_owned_weights(self):
        self.client.login(username='owner', password='password')

        response = self.client.get(reverse('users:preference_weights', args=[self.preference.id]))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                'id': self.preference.id,
                'name': 'Real saved weights',
                'nature': 1.0,
                'entertainment': -0.5,
                'nightlife': -1.0,
                'tourism': 0.5,
                'hospital': 0.5,
            },
        )

    def test_preference_weights_endpoint_rejects_unowned_or_anonymous(self):
        anonymous_response = self.client.get(reverse('users:preference_weights', args=[self.preference.id]))
        self.assertEqual(anonymous_response.status_code, 403)

        self.client.login(username='owner', password='password')
        unowned_response = self.client.get(reverse('users:preference_weights', args=[self.other_preference.id]))
        self.assertEqual(unowned_response.status_code, 404)

    def test_add_and_edit_preferences_honor_next_map_redirect(self):
        self.client.login(username='owner', password='password')
        map_url = reverse('map')

        add_response = self.client.post(
            f"{reverse('users:add_set')}?next={map_url}",
            {**PREFERENCE_FORM_DATA, 'next': map_url},
        )

        self.assertRedirects(add_response, map_url, fetch_redirect_response=False)
        added_preference = self.user.userprofile.preferences.get(name='Low noise route')

        edit_response = self.client.post(
            f"{reverse('users:edit_set', args=[added_preference.id])}?next={map_url}",
            {**PREFERENCE_FORM_DATA, 'name': 'Edited map route', 'nature': '-1', 'next': map_url},
        )

        self.assertRedirects(edit_response, map_url, fetch_redirect_response=False)
        added_preference.refresh_from_db()
        self.assertEqual(added_preference.name, 'Edited map route')
        self.assertEqual(added_preference.nature, -1)

    def test_map_renders_preference_controls_and_weight_urls(self):
        self.client.login(username='owner', password='password')

        response = self.client.get(reverse('map'))

        self.assertContains(response, 'id="preferenceSet"')
        self.assertContains(response, 'data-weights-url-template')
        self.assertContains(response, reverse('users:preference_weights', args=[0]))
        self.assertContains(response, 'id="preferenceEditLink"')
        self.assertContains(response, reverse('users:edit_set', args=[self.preference.id]))
        self.assertContains(response, 'id="preferenceDeleteButton"')
        self.assertContains(response, 'id="preferenceDeleteForm"')

# Create your tests here.
