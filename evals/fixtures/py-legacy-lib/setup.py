from setuptools import setup, find_packages

setup(
    name="textkit",
    version="0.4.1",
    packages=find_packages(exclude=["tests"]),
    install_requires=["six>=1.10"],
)
