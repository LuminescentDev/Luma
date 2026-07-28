#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

@interface LumaKeyboardAssistant : NSObject
@end

@implementation LumaKeyboardAssistant
+ (UIView *)firstResponderInView:(UIView *)view {
	if (view.isFirstResponder) {
		return view;
	}
	for (UIView *child in view.subviews) {
		UIView *responder = [self firstResponderInView:child];
		if (responder != nil) return responder;
	}
	return nil;
}

+ (void)removeAccessoryFromResponder:(UIView *)responder {
	Class currentClass = object_getClass(responder);
	NSString *currentName = NSStringFromClass(currentClass);
	if ([currentName hasSuffix:@"_LumaNoInputAccessory"]) return;

	NSString *subclassName = [currentName stringByAppendingString:@"_LumaNoInputAccessory"];
	Class subclass = NSClassFromString(subclassName);
	if (subclass == Nil) {
		subclass = objc_allocateClassPair(currentClass, subclassName.UTF8String, 0);
		IMP noAccessory = imp_implementationWithBlock(^UIView *(id _self) {
			(void)_self;
			return nil;
		});
		class_addMethod(subclass, @selector(inputAccessoryView), noAccessory, "@@:");
		objc_registerClassPair(subclass);
	}
	object_setClass(responder, subclass);
	[responder reloadInputViews];
}

+ (void)keyboardWillShow:(NSNotification *)notification {
	(void)notification;
	// WebKit finishes configuring the content responder during this notification.
	// Clear its accessory on the next main-queue turn so it cannot reinstall it.
	dispatch_async(dispatch_get_main_queue(), ^{
		for (UIWindow *window in UIApplication.sharedApplication.windows) {
			UIView *responder = [self firstResponderInView:window];
			if (responder != nil) {
				[self removeAccessoryFromResponder:responder];
				break;
			}
		}
	});
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
