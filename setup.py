import os
import django
import subprocess

# Set the Django context
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')
django.setup()

from core.initialization import erase_db, init_db

# Clear the database
erase_db()

# Initialize the database
init_db()

# Run the load_stations.py script
try:
    subprocess.run(['pipenv', 'run', 'python', 'load_stations.py'], check=True)
    print("load_stations.py executed successfully.")
except subprocess.CalledProcessError as e:
    print(f"Error running load_stations.py: {e}")

# Run the load_data.py script
try:
    subprocess.run(['pipenv', 'run', 'python', 'load_data.py'], check=True)
    print("load_data.py executed successfully.")
except subprocess.CalledProcessError as e:
    print(f"Error running load_data.py: {e}")