"""
Async crawler for RCSB PDB.

Library surface:
- RCSBClient: async client for count and id enumeration
- sample_ids: sampling utilities
- download_entries: parallel downloader for PDB/mmCIF files
"""
from .rcsb_client import RCSBClient
from .sampling import sample_ids
from .downloader import download_entries

__all__ = [
    "RCSBClient",
    "sample_ids",
    "download_entries",
]
