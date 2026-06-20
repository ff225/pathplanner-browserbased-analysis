# PathPlanner/Crowdsensing project
The project centres on the creation of an app (I decided to use the Django framework) for path planning. The app is to be a kind of ‘google maps’ in which the user can define a route (departure-arrival). The path will depend on preferences specified in the user's profile.

## Goals
Two main objectives:

-> Data visualisation: by means of a layer system, the user will be able to visualise the data on the map in the form of heat maps, graphics, colours, warnings ...

-> Path planning: to create a customised route based on the preferences specified by the user in their profile.

### Considerations 
The optimal implementation involves the path being generated server-side and then passed, again via API, to the client that is using the application.
The client will have to send the profile information to the server in order to generate the best path based on preferences.

This implementation is currently in ‘stand-by’, everything is currently done client-side.
It is therefore possible that there are problems caused by too many requests for information to the API and problems with ‘slowness’ and loading.

## Project Setup
Follow these steps to set up and run the application:

### 1. Clone the repository
```bash
git clone https://github.com/neRIccardo/PathPlanner.git
cd PathPlanner
```
### 2. Install pipenv

Make sure pipenv is installed.
Locally install dependencies, then open virtual-environment shell with:

```bash
pipenv install
pipenv shell
```
### 3. Install the requirements
Install all project dependencies listed in the requirements.txt file:
```bash
pip install -r requirements.txt
```
### 4. Configure the database
Run the migrations to set up the database:
```bash
python manage.py migrate
```
### 5. Run the following setup file
Run setup.py to populate the DB:
```bash
python setup.py
```
### 6. Start the development server
Start the Django development server:
```bash
python manage.py runserver
```
### 7. Usage
Once the server is running, you can access the site and use the available features.
Go to http://localhost:8000/ and start to explore.