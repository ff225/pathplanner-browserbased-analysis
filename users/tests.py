from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse

from .models import UserPreferences


PREFERENCE_FORM_DATA = {
    'name': 'Low noise route',
    'nature': '8',
    'entertainment': '2',
    'tourism': '4',
    'nightlife': '0',
    'hospital': '7',
}


class PreferenceMapTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='owner', password='password')
        self.other_user = User.objects.create_user(username='other', password='password')
        self.preference = UserPreferences.objects.create(
            name='Real saved weights',
            nature=8,
            entertainment=2,
            tourism=4,
            nightlife=0,
            hospital=7,
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
                'nature': 8.0,
                'entertainment': 2.0,
                'nightlife': 0.0,
                'tourism': 4.0,
                'hospital': 7.0,
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
            {**PREFERENCE_FORM_DATA, 'name': 'Edited map route', 'nature': '6', 'next': map_url},
        )

        self.assertRedirects(edit_response, map_url, fetch_redirect_response=False)
        added_preference.refresh_from_db()
        self.assertEqual(added_preference.name, 'Edited map route')
        self.assertEqual(added_preference.nature, 6)

    def test_signup_collects_profile_fields_and_clinical_default(self):
        response = self.client.post(reverse('users:signup'), {
            'username': 'newpatient',
            'first_name': 'Ada',
            'last_name': 'Lovelace',
            'email': 'ada@example.com',
            'default_pathology': 'respiratory',
            'password1': 'A-strong-demo-pass-2026',
            'password2': 'A-strong-demo-pass-2026',
        })

        self.assertRedirects(response, reverse('map'), fetch_redirect_response=False)
        user = User.objects.get(username='newpatient')
        self.assertEqual(user.first_name, 'Ada')
        self.assertEqual(user.last_name, 'Lovelace')
        self.assertEqual(user.email, 'ada@example.com')
        self.assertEqual(user.userprofile.first_name, 'Ada')
        self.assertEqual(user.userprofile.last_name, 'Lovelace')
        self.assertEqual(user.userprofile.email, 'ada@example.com')
        self.assertEqual(user.userprofile.default_pathology, 'respiratory')

    def test_map_renders_preference_controls_and_weight_urls(self):
        self.client.login(username='owner', password='password')

        response = self.client.get(reverse('map'))

        self.assertContains(response, 'Route style')
        self.assertContains(response, 'id="preferenceSet"')
        self.assertContains(response, 'data-weights-url-template')
        self.assertContains(response, reverse('users:preference_weights', args=[0]))
        self.assertContains(response, 'id="preferenceEditLink"')
        self.assertContains(response, reverse('users:edit_set', args=[self.preference.id]))
        self.assertContains(response, 'id="preferenceDeleteButton"')
        self.assertContains(response, 'id="preferenceDeleteForm"')

    def test_map_and_profile_render_real_user_identity_and_routing_cards(self):
        self.user.email = 'owner@example.com'
        self.user.first_name = 'Dany'
        self.user.last_name = 'Download'
        self.user.save()
        self.user.userprofile.first_name = 'Dany'
        self.user.userprofile.last_name = 'Download'
        self.user.userprofile.email = 'owner@example.com'
        self.user.userprofile.save()
        self.client.login(username='owner', password='password')

        map_response = self.client.get(reverse('map'))
        profile_response = self.client.get(reverse('users:profile'))

        self.assertContains(map_response, 'Dany Download')
        self.assertContains(map_response, 'owner@example.com')
        self.assertNotContains(map_response, '<strong class="d-block">User</strong>')
        self.assertContains(profile_response, 'Saved routing sets')
        self.assertContains(profile_response, 'preference-card')
        self.assertContains(profile_response, 'Real saved weights')

    def test_profile_edit_prefills_locks_email_and_accepts_avatar(self):
        self.user.email = 'owner@example.com'
        self.user.first_name = 'Dany'
        self.user.last_name = 'Download'
        self.user.save()
        self.client.login(username='owner', password='password')

        get_response = self.client.get(reverse('users:edit_profile'))

        self.assertContains(get_response, 'value="Dany"')
        self.assertContains(get_response, 'value="Download"')
        self.assertContains(get_response, 'value="owner@example.com"')
        self.assertContains(get_response, 'disabled')

        image = SimpleUploadedFile(
            'avatar.gif',
            b'GIF87a\x01\x00\x01\x00\x80\x01\x00\x00\x00\x00\xff\xff\xff,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;',
            content_type='image/gif',
        )
        post_response = self.client.post(reverse('users:edit_profile'), {
            'first_name': 'Daniel',
            'last_name': 'Tortoli',
            'email': 'attacker@example.com',
            'default_pathology': 'respiratory',
            'profile_picture': image,
        })

        self.assertRedirects(post_response, reverse('users:profile'))
        self.user.refresh_from_db()
        self.user.userprofile.refresh_from_db()
        self.assertEqual(self.user.first_name, 'Daniel')
        self.assertEqual(self.user.last_name, 'Tortoli')
        self.assertEqual(self.user.email, 'owner@example.com')
        self.assertEqual(self.user.userprofile.email, 'owner@example.com')
        self.assertEqual(self.user.userprofile.default_pathology, 'respiratory')
        self.assertTrue(self.user.userprofile.profile_picture)

# Create your tests here.
