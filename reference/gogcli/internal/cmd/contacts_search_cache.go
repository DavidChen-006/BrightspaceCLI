package cmd

import (
	"context"
	"time"

	"google.golang.org/api/people/v1"
)

var contactsSearchWarmupDelay = 5 * time.Second

func warmSearchContactsCache(ctx context.Context, svc *people.Service) {
	_, err := svc.People.SearchContacts().
		Query("").
		PageSize(1).
		ReadMask("names").
		Context(ctx).
		Do()
	if err != nil {
		return
	}
	waitForContactsSearchWarmup(ctx)
}

func warmSearchOtherContactsCache(ctx context.Context, svc *people.Service) {
	_, err := svc.OtherContacts.Search().
		Query("").
		PageSize(1).
		ReadMask(contactsOtherReadMask).
		Context(ctx).
		Do()
	if err != nil {
		return
	}
	waitForContactsSearchWarmup(ctx)
}

func waitForContactsSearchWarmup(ctx context.Context) {
	if contactsSearchWarmupDelay <= 0 {
		return
	}
	timer := time.NewTimer(contactsSearchWarmupDelay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
