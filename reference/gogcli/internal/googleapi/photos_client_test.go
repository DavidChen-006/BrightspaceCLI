package googleapi

import (
	"net/http"
	"testing"
)

func TestNewPhotosClientNilUsesBoundedClient(t *testing.T) {
	client := NewPhotosClient(nil)
	if client.client == http.DefaultClient {
		t.Fatal("nil PhotosClient fell back to DefaultClient")
	}

	tr, ok := client.client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", client.client.Transport)
	}

	if tr.ResponseHeaderTimeout != responseHeaderTimeout {
		t.Fatalf("ResponseHeaderTimeout = %v", tr.ResponseHeaderTimeout)
	}
}

func TestNewPhotosPickerClientNilUsesBoundedClient(t *testing.T) {
	client := NewPhotosPickerClient(nil)
	if client.client == http.DefaultClient {
		t.Fatal("nil PhotosPickerClient fell back to DefaultClient")
	}

	tr, ok := client.client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", client.client.Transport)
	}

	if tr.ResponseHeaderTimeout != responseHeaderTimeout {
		t.Fatalf("ResponseHeaderTimeout = %v", tr.ResponseHeaderTimeout)
	}
}
