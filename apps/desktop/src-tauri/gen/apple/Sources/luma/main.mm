#include "bindings/bindings.h"
#import <UIKit/UIKit.h>

@interface LumaKeyboardAssistant : NSObject
@end

@implementation LumaKeyboardAssistant
+ (void)hideForFirstResponder:(UIView *)view {
	if (view.isFirstResponder) {
		view.inputAssistantItem.leadingBarButtonGroups = @[];
		view.inputAssistantItem.trailingBarButtonGroups = @[];
		return;
	}
	for (UIView *child in view.subviews) {
		[self hideForFirstResponder:child];
	}
}

+ (void)keyboardWillShow:(NSNotification *)notification {
	(void)notification;
	for (UIWindow *window in UIApplication.sharedApplication.windows) {
		[self hideForFirstResponder:window];
	}
}
@end

int main(int argc, char * argv[]) {
	[NSNotificationCenter.defaultCenter
		addObserver:LumaKeyboardAssistant.class
		selector:@selector(keyboardWillShow:)
		name:UIKeyboardWillShowNotification
		object:nil];
	ffi::start_app();
	return 0;
}
