from django.db import models

# class representing an object of type "Stazione"
class Stazione(models.Model):
    nome = models.CharField(max_length=100)
    codice = models.CharField(max_length=20, unique=True)
    provincia = models.CharField(max_length=2)
    comune = models.CharField(max_length=100)
    indirizzo = models.CharField(max_length=200)
    latitudine = models.FloatField()
    longitudine = models.FloatField()
    nature = models.FloatField(default=0)
    entertainment = models.FloatField(default=0)
    tourism = models.FloatField(default=0)
    nightlife = models.FloatField(default=0)

    def __str__(self):
        return self.nome

# class representing an object of type "Misurazione"
class Misurazione(models.Model):
    stazione = models.ForeignKey(Stazione, on_delete=models.CASCADE)
    data = models.DateField()
    pm10 = models.FloatField(null=True, blank=True)
    pm25 = models.FloatField(null=True, blank=True)
    no2 = models.FloatField(null=True, blank=True)
    o3 = models.FloatField(null=True, blank=True)

class Hospital(models.Model):
    name = models.CharField(max_length=100)
    lat = models.FloatField()
    lng = models.FloatField()

    def __str__(self):
        return self.name